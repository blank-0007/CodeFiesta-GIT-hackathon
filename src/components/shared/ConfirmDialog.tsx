import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label, Textarea, FieldError } from "@/components/ui/form-controls";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  confirmLabel?: string;
  tone?: "default" | "destructive" | "success";
  /** When set, a reason textarea is shown and must have at least this many chars. */
  requireReason?: number;
  reasonLabel?: string;
  onConfirm: (reason: string) => void | Promise<unknown>;
  pending?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  tone = "default",
  requireReason,
  reasonLabel = "Reason",
  onConfirm,
  pending,
}: ConfirmDialogProps) {
  const [reason, setReason] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const id = React.useId();
  React.useEffect(() => {
    if (open) {
      setReason("");
      setTouched(false);
    }
  }, [open]);
  const invalid = requireReason != null && reason.trim().length < requireReason;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (invalid) return;
    await onConfirm(reason.trim());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
          {requireReason != null && (
            <div>
              <Label htmlFor={`${id}-reason`}>
                {reasonLabel} <span className="text-crit">*</span>
              </Label>
              <Textarea
                id={`${id}-reason`}
                className="mt-1"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                aria-invalid={touched && invalid}
                aria-describedby={`${id}-err`}
                placeholder="Explain your decision for the audit trail…"
              />
              <FieldError id={`${id}-err`} message={touched && invalid ? `Please enter at least ${requireReason} characters.` : undefined} />
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant={tone === "destructive" ? "destructive" : tone === "success" ? "success" : "default"} disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
