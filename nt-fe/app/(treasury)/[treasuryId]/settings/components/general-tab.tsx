"use client";

import { Input } from "@/components/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/button";
import { Database, Loader2 } from "lucide-react";
import { useEffect, useState, useRef, useMemo } from "react";
import { PageCard } from "@/components/card";
import { useTreasury } from "@/stores/treasury-store";
import {
  useTreasuryConfig,
  useTreasuryPolicy,
} from "@/hooks/use-treasury-queries";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormField, FormControl, FormItem } from "@/components/ui/form";
import { toast } from "sonner";
import { useNear } from "@/stores/near-store";
import { encodeToMarkdown } from "@/lib/utils";
import { hasPermission } from "@/lib/config-utils";
import { CreateRequestButton } from "@/components/create-request-button";
import { useQueryClient } from "@tanstack/react-query";

const COLOR_OPTIONS = [
  "#6B7280", // gray
  "#EF4444", // red
  "#F97316", // orange
  "#F59E0B", // amber
  "#EAB308", // yellow
  "#84CC16", // lime
  "#22C55E", // green
  "#14B8A6", // teal
  "#06B6D4", // cyan
  "#0EA5E9", // sky
  "#3B82F6", // blue
  "#6366F1", // indigo
  "#8B5CF6", // violet
  "#A855F7", // purple
  "#D946EF", // fuchsia
  "#EC4899", // pink
  "#F43F5E", // rose
];

const generalSchema = z.object({
  displayName: z
    .string()
    .min(1, "Display name is required")
    .max(100, "Display name must be less than 100 characters"),
  accountName: z.string(),
  primaryColor: z.string(),
  logo: z.string().nullable(),
});

type GeneralFormValues = z.infer<typeof generalSchema>;

export function GeneralTab() {
  const { selectedTreasury } = useTreasury();
  const { createProposal } = useNear();
  const { data: policy } = useTreasuryPolicy(selectedTreasury);
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch the treasury config directly by treasuryId
  const { data: currentTreasury } = useTreasuryConfig(selectedTreasury);

  const form = useForm<GeneralFormValues>({
    resolver: zodResolver(generalSchema),
    defaultValues: {
      displayName: "",
      accountName: "",
      primaryColor: "#3B82F6",
      logo: null,
    },
  });

  // Update form when treasury data loads
  useEffect(() => {
    if (currentTreasury) {
      const treasuryData = {
        displayName: currentTreasury.name || "",
        accountName: selectedTreasury || "",
        primaryColor:
          currentTreasury.metadata?.primaryColor || "#3B82F6",
        logo: currentTreasury.metadata?.flagLogo || null,
      };
      form.reset(treasuryData);
    }
  }, [currentTreasury, selectedTreasury, form]);

  const onSubmit = async (data: GeneralFormValues) => {
    if (!selectedTreasury || !currentTreasury) {
      toast.error("Treasury not found");
      return;
    }

    setIsSubmitting(true);
    try {
      const proposalBond = policy?.proposal_bond || "0";

      const metadata = {
        primaryColor: data.primaryColor,
        flagLogo: data.logo,
      };

      const description = {
        title: "Update Config - Theme & logo",
      };

      await createProposal("Request to update configuration submitted", {
        treasuryId: selectedTreasury,
        proposal: {
          description: encodeToMarkdown(description),
          kind: {
            ChangeConfig: {
              config: {
                name: data.displayName,
                purpose: currentTreasury.purpose,
                metadata: Buffer.from(JSON.stringify(metadata)).toString(
                  "base64"
                ),
              },
            },
          },
        },
        proposalBond: proposalBond,
      });

      // Refetch proposals to show the newly created proposal
      queryClient.invalidateQueries({
        queryKey: ["proposals", selectedTreasury],
      });

      // Reset form to mark as not dirty
      form.reset(data);
    } catch (error) {
      console.error("Error creating proposal:", error);
      toast.error("Failed to create proposal");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleColorChange = (color: string) => {
    form.setValue("primaryColor", color, { shouldDirty: true });
  };

  const uploadImageToServer = async (file: File) => {
    setUploadingImage(true);

    try {
      const response = await fetch("https://ipfs.near.social/add", {
        method: "POST",
        headers: { Accept: "application/json" },
        body: file,
      });

      const result = await response.json();
      if (result.cid) {
        const imageUrl = `https://ipfs.near.social/ipfs/${result.cid}`;
        form.setValue("logo", imageUrl, { shouldDirty: true });
        toast.success("Logo uploaded successfully");
      } else {
        toast.error("Error occurred while uploading image, please try again.");
      }
    } catch (error) {
      console.error("Upload error:", error);
      toast.error("Error occurred while uploading image, please try again.");
    } finally {
      setUploadingImage(false);
    }
  };

  const handleImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();

    reader.onload = () => {
      const img = new Image();
      img.src = reader.result as string;

      img.onload = () => {
        // Check dimensions
        if (img.width === 256 && img.height === 256) {
          uploadImageToServer(file);
        } else {
          toast.error(
            "Invalid logo. Please upload a PNG, JPG, or SVG file that is exactly 256x256 px"
          );
        }
      };

      img.onerror = () => {
        toast.error("Invalid image file. Please upload a valid image.");
      };
    };

    reader.onerror = () => {
      console.error("Error reading file");
      toast.error("Error reading file. Please try again.");
    };

    reader.readAsDataURL(file);

    // Reset the input value so the same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <PageCard>
          <div>
            <h3 className="text-lg font-semibold">Treasury Name</h3>
            <p className="text-sm text-muted-foreground">
              The name of your treasury. This will be displayed across the app.
            </p>
          </div>

          <div className="space-y-4">
            <FormField
              control={form.control}
              name="displayName"
              render={({ field }) => (
                <FormItem>
                  <div className="space-y-2">
                    <Label htmlFor="display-name">Display Name</Label>
                    <FormControl>
                      <Input
                        id="display-name"
                        clearable={false}
                        {...field}
                        placeholder="Enter display name"
                      />
                    </FormControl>
                    {form.formState.errors.displayName && (
                      <p className="text-sm text-destructive">
                        {form.formState.errors.displayName.message}
                      </p>
                    )}
                  </div>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="accountName"
              render={({ field }) => (
                <FormItem>
                  <div className="space-y-2">
                    <Label htmlFor="account-name">Account Name</Label>
                    <FormControl>
                      <Input id="account-name" clearable={false} {...field} disabled={true} />
                    </FormControl>
                  </div>
                </FormItem>
              )}
            />
          </div>
        </PageCard>

        <PageCard>
          <div>
            <h3 className="text-lg font-semibold">Logo</h3>
            <p className="text-sm text-muted-foreground">
              Upload a logo for your treasury. Recommended SVG, PNG, or JPG
              (256x256 px).
            </p>
          </div>
          <FormField
            control={form.control}
            name="logo"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center gap-4">
                  <div className="flex h-16 w-16 items-center justify-center rounded-lg">
                    {field.value ? (
                      <img
                        src={field.value}
                        alt="Treasury logo"
                        className="h-full w-full rounded-lg object-cover"
                      />
                    ) : (
                      <div className="bg-muted rounded-full p-2.5">
                        <Database className="h-8 w-8 shrink-0 text-muted-foreground " />
                      </div>
                    )}
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png, image/jpeg, image/svg+xml"
                    onChange={handleImageChange}
                    className="hidden"
                  />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleUploadClick}
                      disabled={uploadingImage}
                    >
                      {uploadingImage ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Uploading...
                        </>
                      ) : (
                        "Upload Logo"
                      )}
                    </Button>
                    {field.value && (
                      <Button
                        type="button"
                        variant="link"
                        onClick={() => {
                          field.onChange("");
                          form.setValue("logo", "", { shouldDirty: true });
                        }}
                        disabled={uploadingImage}
                      >
                        Remove Logo
                      </Button>
                    )}
                  </div>
                </div>
              </FormItem>
            )}
          />
        </PageCard>

        <PageCard>
          <div>
            <h3 className="text-lg font-semibold">Primary Color</h3>
            <p className="text-sm text-muted-foreground">
              Set the primary color for your treasury's interface elements. This
              color will be used in both light and dark modes, so keep contrast
              in mind when choosing neutral shades.
            </p>
          </div>

          <FormField
            control={form.control}
            name="primaryColor"
            render={({ field }) => (
              <FormItem>
                <div className="flex flex-wrap gap-2">
                  {COLOR_OPTIONS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => handleColorChange(color)}
                      className={`h-8 w-8 rounded-full transition-all hover:scale-110 ${field.value === color
                        ? "ring-2 ring-offset-2 ring-offset-background ring-primary"
                        : ""
                        }`}
                      style={{ backgroundColor: color }}
                      aria-label={`Select color ${color}`}
                    />
                  ))}
                </div>
              </FormItem>
            )}
          />
        </PageCard>

        <div className="rounded-lg border bg-card">
          <CreateRequestButton
            type="submit"
            isSubmitting={isSubmitting}
            permissions={{ kind: "config", action: "AddProposal" }}
            disabled={!form.formState.isDirty}
          />
        </div>
      </form>
    </Form>
  );
}
