import { type ReactNode } from "react";

import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "~/components/ui/sheet";

// Upstream main's Escape tests mount viewers in RightPanelSheet, which the redesign's panes removed.
export function DismissibleSheet(props: { children?: ReactNode; onClose: () => void }) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <SheetPopup transitionDurationMs={0} side="right" showCloseButton={false} keepMounted>
        <SheetHeader className="sr-only">
          <SheetTitle>Sheet</SheetTitle>
        </SheetHeader>
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
