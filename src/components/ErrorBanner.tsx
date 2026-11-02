import { X } from "lucide-react";

import { useCampaignStore } from "@/stores/campaign-store";

export function ErrorBanner() {
  const error = useCampaignStore((s) => s.error);
  const clearError = useCampaignStore((s) => s.clearError);
  if (!error) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-3 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-200"
    >
      <span className="flex-1 break-words">{error}</span>
      <button
        type="button"
        onClick={clearError}
        aria-label="Dismiss"
        className="rounded p-0.5 hover:bg-red-500/20"
      >
        <X size={16} />
      </button>
    </div>
  );
}
