import { useState, useMemo, useCallback, ReactNode } from "react";
import { Input } from "@/components/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/modal";
import { SelectList, SelectListItem } from "@/components/select-list";

export interface SelectOption extends SelectListItem { }

interface SelectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (option: SelectOption) => void;
  title: string;
  options: SelectOption[];
  searchPlaceholder?: string;
  isLoading?: boolean;
  selectedId?: string;
}

export function SelectModal({
  isOpen,
  onClose,
  onSelect,
  title,
  options,
  searchPlaceholder = "Search by name",
  isLoading = false,
  selectedId,
}: SelectModalProps) {
  const [searchQuery, setSearchQuery] = useState("");

  const filteredOptions = useMemo(() => {
    if (!searchQuery) return options;

    const query = searchQuery.toLowerCase();
    return options.filter(
      (option) =>
        (option.name || "").toLowerCase().includes(query) ||
        (option.symbol || "").toLowerCase().includes(query)
    );
  }, [options, searchQuery]);

  const handleSelect = useCallback(
    (option: SelectOption) => {
      onSelect(option);
      setSearchQuery("");
      onClose();
    },
    [onSelect, onClose]
  );

  const handleClose = useCallback(() => {
    setSearchQuery("");
    onClose();
  }, [onClose]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader centerTitle>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <Input
            type="text"
            search
            placeholder={searchPlaceholder}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          <SelectList
            items={filteredOptions}
            onSelect={handleSelect}
            isLoading={isLoading}
            selectedId={selectedId}
            emptyMessage="No results found"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
