import { RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/Button";
import { Portrait } from "@/features/images/Portrait";
import { portraitOf } from "@/features/images/portrait-model";
import { storage } from "@/lib/tauri";
import { elementLabel } from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

import { TRASH_KEEP_DAYS, daysLeft, deletedWhen } from "./trash-model";

/**
 * The list column for "Recently deleted": every element in the campaign's
 * `.trash/` folder, newest first, each with Restore and a bin that removes
 * it for good. Restoring opens the element in the main column.
 */
export function TrashList() {
  const trash = useCampaignStore((s) => s.trash);
  const refreshTrash = useCampaignStore((s) => s.refreshTrash);
  const restoreElement = useCampaignStore((s) => s.restoreElement);
  const purgeElement = useCampaignStore((s) => s.purgeElement);
  const [confirming, setConfirming] = useState<string | null>(null);

  // The list is read from disk when the view opens, so a file put in the
  // folder by hand (or by another window) shows up too.
  useEffect(() => {
    void refreshTrash();
  }, [refreshTrash]);

  return (
    <>
      <div className="border-b border-ink-800 px-3 py-2">
        <h2 className="text-sm font-medium text-ink-100">Recently deleted</h2>
        <p className="mt-0.5 text-[11px] leading-snug text-ink-500">
          Kept in the campaign folder for {TRASH_KEEP_DAYS} days, then removed.
          Restoring brings an element back with its id, so links to it work
          again.
        </p>
      </div>
      <ul className="flex-1 overflow-y-auto py-1">
        {trash.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-ink-500">
            Nothing deleted recently.
          </li>
        )}
        {trash.map((e) => {
          const left = daysLeft(e.deletedAt);
          return (
            <li key={e.id} className="flex items-center gap-3 px-4 py-2">
              <Portrait
                path={portraitOf(e)}
                name={e.name}
                kind={e.type}
                size={30}
                scope="local"
                load={storage.readAsset}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ink-100">{e.name}</div>
                <div
                  className="truncate text-[11px] text-ink-500"
                  title={`Was ${e.deletedFrom}`}
                >
                  {elementLabel(e)} · deleted {deletedWhen(e.deletedAt)} ·{" "}
                  {left === 0
                    ? "goes next time the campaign opens"
                    : `${left} ${left === 1 ? "day" : "days"} left`}
                </div>
              </div>
              {confirming === e.id ? (
                <span className="flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 py-0.5 pl-2 pr-0.5 text-[11px] text-red-200">
                  For good?
                  <Button
                    variant="danger"
                    size="sm"
                    autoFocus
                    onClick={() => {
                      setConfirming(null);
                      void purgeElement(e.id);
                    }}
                    onKeyDown={(ev) =>
                      ev.key === "Escape" && setConfirming(null)
                    }
                  >
                    Delete
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirming(null)}
                  >
                    Keep
                  </Button>
                </span>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void restoreElement(e.id)}
                    title="Put it back where it was and open it"
                  >
                    <RotateCcw size={13} /> Restore
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => setConfirming(e.id)}
                    aria-label={`Delete ${e.name} for good`}
                    title="Delete for good"
                  >
                    <Trash2 size={13} />
                  </Button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
