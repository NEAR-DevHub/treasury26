"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/modal";
import { Button } from "@/components/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useNear } from "@/stores/near-store";
import { Loader2 } from "lucide-react";
import Link from "next/link";

interface AcceptTermsModalProps {
  open: boolean;
}

export function AcceptTermsModal({ open }: AcceptTermsModalProps) {
  const [accepted, setAccepted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { acceptTerms } = useNear();

  const handleAccept = async () => {
    if (!accepted) return;

    setIsSubmitting(true);
    try {
      await acceptTerms();
    } catch (error) {
      console.error("Failed to accept terms:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open}>
      <DialogContent
        className="sm:max-w-md"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        showCloseButton={false}
      >
        <DialogHeader closeButton={false}>
          <DialogTitle>
            Accept Terms to Continue
          </DialogTitle>
        </DialogHeader>

        <DialogDescription>
          To continue using the app, you need to accept our Terms of Service and
          Privacy Policy. These terms define how the app works and how we handle
          your data.
        </DialogDescription>

        <div className="flex items-start gap-3">
          <Checkbox
            id="terms"
            checked={accepted}
            className="mt-0.5"
            onCheckedChange={(checked) => setAccepted(checked === true)}
            disabled={isSubmitting}
          />
          <Label
            htmlFor="terms"
            className="text-sm inline-block leading-relaxed cursor-pointer"
          >
            I have read and agree to the{" "}
            <Link
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-4 hover:text-primary/80"
            >
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-4 hover:text-primary/80"
            >
              Privacy Policy
            </Link>
          </Label>
        </div>

        <DialogFooter>
          <Button
            onClick={handleAccept}
            disabled={!accepted || isSubmitting}
            className="w-full"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Accepting...
              </>
            ) : (
              "Continue"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
