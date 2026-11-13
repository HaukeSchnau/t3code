import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";

import { readThreadShell } from "~/state/entities";
import { followUpEnvironment, followUpHomeOfAtom } from "~/state/followUps";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

/** Turns a passage the user selected in an assistant message into a follow-up on the home. */
export function QuoteFollowUpDialog(props: {
  readonly threadRef: ScopedThreadRef;
  readonly messageId: MessageId;
  readonly quote: string;
  readonly onClose: () => void;
}) {
  const { threadRef } = props;
  const id = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const home = useAtomValue(followUpHomeOfAtom(threadRef.environmentId));
  const canSave = useAtomValue(followUpEnvironment.save.permissionAtom(home));
  const save = useAtomCommand(followUpEnvironment.save, { reportFailure: false });
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const trimmed = title.trim();
    if (trimmed === "" || saving) return;
    setSaving(true);
    const result = await save({
      environmentId: home,
      input: {
        title: trimmed,
        body: note.trim(),
        origin: {
          environmentId: threadRef.environmentId,
          threadId: threadRef.threadId,
          messageId: props.messageId,
          quote: props.quote,
          threadTitle: readThreadShell(threadRef)?.title ?? null,
        },
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not save the follow-up",
          description: failure instanceof Error ? failure.message : "An error occurred.",
        });
      }
      return;
    }
    props.onClose();
    const followUpId = result.value.id;
    const toastId = toastManager.add({
      type: "success",
      title: "Follow-up saved",
      description: trimmed,
      actionProps: {
        children: "Open",
        onClick: () => {
          toastManager.close(toastId);
          void navigate({ to: "/follow-ups", search: { id: followUpId } });
        },
      },
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md" initialFocus={titleRef}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New follow-up</DialogTitle>
            <DialogDescription>
              It keeps this passage and links back to the message.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <blockquote className="max-h-40 overflow-y-auto border-l-2 border-border ps-3 text-sm whitespace-pre-wrap text-muted-foreground">
                {props.quote}
              </blockquote>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-title`}>Title</Label>
                <Input
                  ref={titleRef}
                  id={`${id}-title`}
                  required
                  value={title}
                  placeholder="What to come back to"
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-note`}>Note (optional)</Label>
                <Textarea
                  id={`${id}-note`}
                  rows={3}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
              </div>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave || saving || title.trim() === ""}>
              {saving ? "Saving…" : "Save follow-up"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
