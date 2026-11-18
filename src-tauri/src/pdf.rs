//! Plain text out of a PDF, page by page, for the import wizard and the
//! assistant's `read_document` tool.
//!
//! Extraction is pure CPU work over bytes already in memory and runs on a
//! blocking thread. `pdf-extract` panics on some malformed files, so each
//! call is wrapped in `catch_unwind` and surfaces as an error instead of
//! taking the app down (the release profile unwinds for this reason).

use std::panic::{AssertUnwindSafe, catch_unwind};

use serde::Serialize;

/// Hard ceiling on how much text one extraction returns, so a scanned
/// thousand-page tome cannot wedge the webview. ~15 MB of UTF-8.
const MAX_TOTAL_CHARS: usize = 15 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfText {
    /// Pages in the document, whatever range was asked for.
    pub page_count: usize,
    /// 1-based number of the first page in `pages`.
    pub first_page: usize,
    /// Text of each page in the requested range, cleaned up. A page that
    /// could not be read is an empty string so numbering stays aligned.
    pub pages: Vec<String>,
    /// Pages in the range that yielded no text at all (likely scans).
    pub empty_pages: usize,
    /// Total characters across `pages`.
    pub chars: usize,
    /// True when the text was cut at `MAX_TOTAL_CHARS`.
    pub truncated: bool,
}

/// Extracts text from `bytes`. `from`/`to` are 1-based inclusive page
/// numbers; `None` means the start / the end.
pub fn extract(bytes: &[u8], from: Option<usize>, to: Option<usize>) -> Result<PdfText, String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("that does not look like a PDF file".into());
    }
    let result = catch_unwind(AssertUnwindSafe(|| extract_inner(bytes, from, to)));
    match result {
        Ok(inner) => inner,
        Err(_) => Err("the PDF could not be read (its structure confused the parser)".into()),
    }
}

/// Opens a PDF held in memory, unlocking it when an empty password does.
fn load(bytes: &[u8]) -> Result<pdf_extract::Document, String> {
    let mut doc = pdf_extract::Document::load_mem(bytes)
        .map_err(|e| format!("could not open the PDF: {e}"))?;
    if doc.is_encrypted() {
        // An empty user password is common (the file is only "protected"
        // against editing); anything else we cannot ask for here.
        doc.decrypt("")
            .map_err(|_| "the PDF is password-protected".to_owned())?;
    }
    Ok(doc)
}

fn extract_inner(bytes: &[u8], from: Option<usize>, to: Option<usize>) -> Result<PdfText, String> {
    let doc = load(bytes)?;
    let page_count = doc.get_pages().len();
    if page_count == 0 {
        return Err("the PDF has no pages".into());
    }
    let first = from.unwrap_or(1).clamp(1, page_count);
    let last = to.unwrap_or(page_count).clamp(first, page_count);

    let mut pages = Vec::with_capacity(last - first + 1);
    let mut chars = 0usize;
    let mut empty_pages = 0usize;
    let mut truncated = false;
    for n in first..=last {
        let text = page_text(&doc, n as u32)
            .map(|t| clean(&t))
            .unwrap_or_default();
        if text.is_empty() {
            empty_pages += 1;
        }
        if chars + text.len() > MAX_TOTAL_CHARS {
            truncated = true;
            break;
        }
        chars += text.len();
        pages.push(text);
    }
    Ok(PdfText {
        page_count,
        first_page: first,
        pages,
        empty_pages,
        chars,
        truncated,
    })
}

/// A copy of the PDF holding only pages `from..=to` (1-based, inclusive,
/// clamped to the document), for sending a scanned book to the model a few
/// pages at a time. Objects the kept pages do not reach are dropped, so a
/// slice of a scan is about its pages' images and little else.
pub fn slice(bytes: &[u8], from: usize, to: usize) -> Result<Vec<u8>, String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("that does not look like a PDF file".into());
    }
    let result = catch_unwind(AssertUnwindSafe(|| slice_inner(bytes, from, to)));
    match result {
        Ok(inner) => inner,
        Err(_) => Err("the PDF could not be read (its structure confused the parser)".into()),
    }
}

fn slice_inner(bytes: &[u8], from: usize, to: usize) -> Result<Vec<u8>, String> {
    let mut doc = load(bytes)?;
    let page_count = doc.get_pages().len();
    if page_count == 0 {
        return Err("the PDF has no pages".into());
    }
    let first = from.clamp(1, page_count);
    let last = to.clamp(first, page_count);
    let dropped: Vec<u32> = (1..=page_count)
        .filter(|n| *n < first || *n > last)
        .map(|n| n as u32)
        .collect();
    if !dropped.is_empty() {
        doc.delete_pages(&dropped);
        doc.prune_objects();
    }
    let mut out = Vec::new();
    doc.save_to(&mut out)
        .map_err(|e| format!("could not write the page range: {e}"))?;
    Ok(out)
}

/// Splits text kept beside a PDF (one entry per page, form feeds between)
/// into exactly `page_count` pages, so page numbers line up with the PDF.
pub fn sidecar_pages(raw: &str, page_count: usize) -> Vec<String> {
    let mut pages: Vec<String> = raw.split('\u{0c}').map(clean).collect();
    pages.resize(page_count, String::new());
    pages
}

/// Characters per pseudo-page when a text file has no page marks.
const TEXT_PAGE_CHARS: usize = 3000;

/// Pseudo-pages for a plain-text file, so it goes through the same import
/// as a PDF. Form feeds mark pages when present (OCR dumps such as Internet
/// Archive's `_djvu.txt` use them); otherwise the text is cut into pages of
/// about `TEXT_PAGE_CHARS` at paragraph breaks. `from`/`to` as for `extract`.
pub fn paginate_text(raw: &str, from: Option<usize>, to: Option<usize>) -> Result<PdfText, String> {
    let all: Vec<String> = if raw.contains('\u{0c}') {
        raw.split('\u{0c}').map(clean).collect()
    } else {
        let mut pages = Vec::new();
        let mut buf = String::new();
        for para in clean(raw).split("\n\n") {
            if !buf.is_empty() && buf.len() + para.len() > TEXT_PAGE_CHARS {
                pages.push(std::mem::take(&mut buf));
            }
            if !buf.is_empty() {
                buf.push_str("\n\n");
            }
            buf.push_str(para);
        }
        if !buf.is_empty() {
            pages.push(buf);
        }
        pages
    };
    let page_count = all.len();
    if page_count == 0 || all.iter().all(|p| p.is_empty()) {
        return Err("the file has no text".into());
    }
    let first = from.unwrap_or(1).clamp(1, page_count);
    let last = to.unwrap_or(page_count).clamp(first, page_count);

    let mut pages = Vec::with_capacity(last - first + 1);
    let mut chars = 0usize;
    let mut empty_pages = 0usize;
    let mut truncated = false;
    for text in &all[first - 1..last] {
        if text.is_empty() {
            empty_pages += 1;
        }
        if chars + text.len() > MAX_TOTAL_CHARS {
            truncated = true;
            break;
        }
        chars += text.len();
        pages.push(text.clone());
    }
    Ok(PdfText {
        page_count,
        first_page: first,
        pages,
        empty_pages,
        chars,
        truncated,
    })
}

fn page_text(doc: &pdf_extract::Document, page: u32) -> Option<String> {
    let mut s = String::new();
    {
        let mut out = pdf_extract::PlainTextOutput::new(&mut s);
        // A page with a broken content stream or an unknown font is skipped;
        // the caller sees an empty page rather than losing the whole book.
        let result = catch_unwind(AssertUnwindSafe(|| {
            pdf_extract::output_doc_page(doc, &mut out, page)
        }));
        match result {
            Ok(Ok(())) => {}
            _ => return None,
        }
    }
    Some(s)
}

/// Normalises extracted text: drops control characters, collapses runs of
/// spaces, trims each line and squeezes blank-line runs to one.
fn clean(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut blank_run = 0usize;
    for line in raw.lines() {
        let mut collapsed = String::with_capacity(line.len());
        let mut last_space = true;
        for ch in line.chars() {
            // Tabs are control characters too: test whitespace first.
            if ch.is_whitespace() {
                if !last_space {
                    collapsed.push(' ');
                }
                last_space = true;
            } else if ch.is_control() {
                continue;
            } else {
                collapsed.push(ch);
                last_space = false;
            }
        }
        let trimmed = collapsed.trim_end();
        if trimmed.is_empty() {
            blank_run += 1;
            if blank_run == 1 && !out.is_empty() {
                out.push('\n');
            }
            continue;
        }
        blank_run = 0;
        out.push_str(trimmed);
        out.push('\n');
    }
    out.trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_pdf_bytes() {
        let err = extract(b"hello", None, None).unwrap_err();
        assert!(err.contains("PDF"));
    }

    #[test]
    fn garbage_after_header_is_an_error_not_a_panic() {
        let err = extract(b"%PDF-1.7 not really a pdf", None, None).unwrap_err();
        assert!(!err.is_empty());
    }

    /// Smoke test against a real file: `CF_TEST_PDF=path cargo test -- --ignored real_pdf`.
    #[test]
    #[ignore]
    fn real_pdf_yields_text() {
        let path = std::env::var("CF_TEST_PDF").expect("CF_TEST_PDF not set");
        let bytes = std::fs::read(&path).unwrap();
        let text = extract(&bytes, None, Some(2)).unwrap();
        eprintln!(
            "pages={} range={}..{} chars={} empty={} first words={:?}",
            text.page_count,
            text.first_page,
            text.first_page + text.pages.len() - 1,
            text.chars,
            text.empty_pages,
            text.pages[0].split_whitespace().take(6).collect::<Vec<_>>()
        );
        assert!(text.chars > 0);
    }

    #[test]
    fn text_with_form_feeds_splits_on_them() {
        let text = paginate_text("Page one\u{0c}Page two\u{0c}\u{0c}Four", Some(2), None).unwrap();
        assert_eq!(text.page_count, 4);
        assert_eq!(text.first_page, 2);
        assert_eq!(text.pages, vec!["Page two", "", "Four"]);
        assert_eq!(text.empty_pages, 1);
    }

    #[test]
    fn text_without_marks_is_cut_at_paragraphs() {
        let para = "x".repeat(1200);
        let raw = format!("{para}\n\n{para}\n\n{para}\n\n{para}");
        let text = paginate_text(&raw, None, None).unwrap();
        // 1200 + 1200 fits a 3000-character page; a third would not.
        assert_eq!(text.page_count, 2);
        assert_eq!(text.pages[0].len(), 2402);
        assert!(paginate_text("  \n\n ", None, None).is_err());
    }

    /// A three-page PDF built in memory, each page a bare content stream.
    fn three_page_pdf() -> Vec<u8> {
        use pdf_extract::{Dictionary, Object, Stream, dictionary};
        let mut doc = pdf_extract::Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut kids = Vec::new();
        for n in 1..=3 {
            let content = Stream::new(
                Dictionary::new(),
                format!("BT (Page {n}) Tj ET").into_bytes(),
            );
            let content_id = doc.add_object(content);
            let page_id = doc.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "Contents" => content_id,
            });
            kids.push(Object::Reference(page_id));
        }
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => 3,
            }),
        );
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog_id);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    #[test]
    fn slice_keeps_only_the_requested_pages() {
        let whole = three_page_pdf();
        let sliced = slice(&whole, 2, 3).unwrap();
        let doc = pdf_extract::Document::load_mem(&sliced).unwrap();
        assert_eq!(doc.get_pages().len(), 2);
        // Out-of-range bounds clamp rather than fail.
        let one = slice(&whole, 3, 10).unwrap();
        assert_eq!(
            pdf_extract::Document::load_mem(&one)
                .unwrap()
                .get_pages()
                .len(),
            1
        );
        assert!(slice(b"nope", 1, 1).is_err());
    }

    #[test]
    fn sidecar_pages_line_up_with_the_document() {
        let pages = sidecar_pages("one\u{0c}\u{0c} three ", 5);
        assert_eq!(pages, vec!["one", "", "three", "", ""]);
        assert_eq!(sidecar_pages("a\u{0c}b\u{0c}c", 2), vec!["a", "b"]);
    }

    #[test]
    fn clean_squeezes_whitespace() {
        let raw = "  The   Rusty\tTankard \n\n\n\nA   tavern.\u{0}\n";
        assert_eq!(clean(raw), "The Rusty Tankard\n\nA tavern.");
    }
}
