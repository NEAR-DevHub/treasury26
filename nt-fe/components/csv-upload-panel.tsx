"use client";

import { useState, useEffect, useId } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { ScrollContainer } from "@/components/scroll-container";
import { Textarea } from "@/components/textarea";
import { Upload, FileText, X } from "lucide-react";
import {
    Tabs,
    TabsList,
    TabsTrigger,
    TabsContent,
} from "@/components/underline-tabs";

interface CsvUploadPanelProps {
    csvData: string | null;
    onCsvDataChange: (data: string | null) => void;
    pasteData: string;
    onPasteDataChange: (data: string) => void;
    activeTab: "upload" | "paste";
    onActiveTabChange: (tab: "upload" | "paste") => void;
    uploadedFileName: string | null;
    onUploadedFileNameChange: (name: string | null) => void;
    templateCsvContent: string;
    templateFileName: string;
    pastePlaceholder: string;
    errors: Array<{ row: number; message: string }> | null;
    onErrorsClear: () => void;
    disabled?: boolean;
    maxFileSizeMB?: number;
}

export function CsvUploadPanel({
    csvData,
    onCsvDataChange,
    pasteData,
    onPasteDataChange,
    activeTab,
    onActiveTabChange,
    uploadedFileName,
    onUploadedFileNameChange,
    templateCsvContent,
    templateFileName,
    pastePlaceholder,
    errors,
    onErrorsClear,
    disabled = false,
    maxFileSizeMB = 1.5,
}: CsvUploadPanelProps) {
    const t = useTranslations("csvUpload");
    const inputId = useId();
    const [isDragging, setIsDragging] = useState(false);
    const [uploadedFile, setUploadedFile] = useState<File | null>(null);

    // Restore uploaded file state when navigating back
    useEffect(() => {
        if (uploadedFileName && !uploadedFile) {
            const file = new File([""], uploadedFileName, { type: "text/csv" });
            setUploadedFile(file);
        }
    }, [uploadedFileName, uploadedFile]);

    const handleFileUpload = (file: File) => {
        if (file.type !== "text/csv" && !file.name.endsWith(".csv")) {
            return;
        }

        if (file.size > maxFileSizeMB * 1024 * 1024) {
            return;
        }

        onErrorsClear();
        setUploadedFile(file);
        onUploadedFileNameChange(file.name);

        const reader = new FileReader();
        reader.onload = (e) => {
            const text = e.target?.result as string;
            onCsvDataChange(text);
        };
        reader.readAsText(file);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);

        const file = e.dataTransfer.files[0];
        if (file) {
            handleFileUpload(file);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = () => {
        setIsDragging(false);
    };

    const downloadTemplate = () => {
        const blob = new Blob([templateCsvContent], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = templateFileName;
        a.click();
        URL.revokeObjectURL(url);
    };

    const clearFile = () => {
        setUploadedFile(null);
        onCsvDataChange(null);
        onUploadedFileNameChange(null);
        onErrorsClear();
    };

    const hasErrors = errors && errors.length > 0;

    return (
        <Tabs
            value={activeTab}
            onValueChange={(value) => {
                onActiveTabChange(value as "upload" | "paste");
                onErrorsClear();
            }}
        >
            <TabsList>
                <TabsTrigger value="upload">{t("uploadFile")}</TabsTrigger>
                <TabsTrigger value="paste">{t("provideData")}</TabsTrigger>
            </TabsList>

            {/* Upload Tab */}
            <TabsContent value="upload">
                <div className="space-y-4">
                    {!uploadedFile ? (
                        <>
                            <div
                                className={`border-2 border-dashed hover:bg-general-tertiary focus-within:bg-general-tertiary transition-colors rounded-lg p-4 text-center ${
                                    isDragging
                                        ? "border-primary bg-primary/5"
                                        : "border-border bg-muted"
                                }`}
                                onDrop={handleDrop}
                                onDragOver={handleDragOver}
                                onDragLeave={handleDragLeave}
                            >
                                <div className="flex flex-col items-center gap-4">
                                    <Upload className="w-6 h-6 text-muted-foreground" />
                                    <div>
                                        <p className="text-base mb-2">
                                            <Button
                                                type="button"
                                                variant="link"
                                                className="font-semibold h-auto p-0! hover:underline disabled:text-muted-foreground"
                                                onClick={() =>
                                                    document
                                                        .getElementById(inputId)
                                                        ?.click()
                                                }
                                                disabled={disabled}
                                            >
                                                {t("chooseFile")}
                                            </Button>{" "}
                                            <span className="text-muted-foreground font-medium">
                                                {t("orDragDrop")}
                                            </span>
                                        </p>
                                        <p className="text-sm text-muted-foreground">
                                            {t("maxFileSize", {
                                                maxSize: maxFileSizeMB,
                                            })}
                                        </p>
                                    </div>
                                    <input
                                        id={inputId}
                                        type="file"
                                        accept=".csv"
                                        className="hidden"
                                        disabled={disabled}
                                        onChange={(e) => {
                                            const file = e.target.files?.[0];
                                            if (file) handleFileUpload(file);
                                        }}
                                    />
                                </div>
                            </div>

                            <div className="flex items-center gap-2 text-sm">
                                <span className="text-muted-foreground">
                                    {t("noFilePrompt")}
                                </span>
                                <Button
                                    type="button"
                                    variant="link"
                                    onClick={downloadTemplate}
                                    className="h-auto p-0! font-medium hover:underline text-general-unofficial-ghost-foreground"
                                >
                                    {t("downloadTemplate")}
                                </Button>
                            </div>
                        </>
                    ) : (
                        <div
                            className={`rounded-lg p-4 flex items-center justify-between ${
                                hasErrors
                                    ? "bg-destructive/10 border border-destructive"
                                    : "bg-muted/50"
                            }`}
                        >
                            <div className="flex items-center gap-3">
                                <FileText
                                    className={`w-5 h-5 ${
                                        hasErrors
                                            ? "text-destructive"
                                            : "text-primary"
                                    }`}
                                />
                                <div>
                                    <p className="text-sm font-medium">
                                        {uploadedFile.name}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        {(uploadedFile.size / 1024).toFixed(0)}
                                        KB
                                    </p>
                                </div>
                            </div>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={clearFile}
                                className={`h-8 w-8 ${
                                    hasErrors
                                        ? "text-destructive hover:text-destructive/80"
                                        : "text-muted-foreground hover:text-foreground"
                                }`}
                            >
                                <X className="w-4 h-4" />
                            </Button>
                        </div>
                    )}

                    {/* Errors below file upload */}
                    {activeTab === "upload" && hasErrors && (
                        <ScrollContainer className="space-y-1 max-h-48">
                            {errors.map((error, idx) => (
                                <div
                                    key={idx}
                                    className="text-sm text-destructive"
                                >
                                    {error.message}
                                </div>
                            ))}
                        </ScrollContainer>
                    )}
                </div>
            </TabsContent>

            {/* Paste Tab */}
            <TabsContent value="paste">
                <div className="space-y-2">
                    <Textarea
                        value={pasteData}
                        onChange={(e) => {
                            onPasteDataChange(e.target.value);
                            if (hasErrors) {
                                onErrorsClear();
                            }
                        }}
                        borderless
                        placeholder={pastePlaceholder}
                        rows={8}
                        className={`resize-none font-mono text-sm bg-muted focus:outline-none break-all whitespace-pre-wrap min-h-41 ${
                            hasErrors
                                ? "border border-destructive bg-destructive/5! focus:border-destructive!"
                                : "bg-muted"
                        }`}
                        disabled={disabled}
                    />

                    {/* Errors below textarea */}
                    {hasErrors && (
                        <ScrollContainer className="space-y-1 max-h-48">
                            {errors.map((error, idx) => (
                                <div
                                    key={idx}
                                    className="text-sm text-destructive"
                                >
                                    {error.message}
                                </div>
                            ))}
                        </ScrollContainer>
                    )}
                </div>
            </TabsContent>
        </Tabs>
    );
}
