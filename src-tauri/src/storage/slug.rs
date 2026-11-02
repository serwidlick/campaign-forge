/// Turns free text into a safe, lowercase, hyphenated path segment.
///
/// Anything that is not ASCII alphanumeric becomes a hyphen; runs of hyphens
/// collapse; leading and trailing hyphens are trimmed. Empty input yields
/// "untitled". The result never contains path separators or dots, so it can be
/// joined onto a directory without escaping it.
pub fn slugify(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last_dash = true; // suppress a leading dash
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "untitled".to_owned()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::slugify;

    #[test]
    fn basic() {
        assert_eq!(slugify("The Rusty Tankard"), "the-rusty-tankard");
    }

    #[test]
    fn strips_path_characters() {
        assert_eq!(slugify("../../etc/passwd"), "etc-passwd");
    }

    #[test]
    fn empty_becomes_untitled() {
        assert_eq!(slugify("   "), "untitled");
    }
}
