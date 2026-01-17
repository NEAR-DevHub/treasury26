import { useState, useMemo, useCallback } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/input";
import { Button } from "@/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/modal";

interface SelectOption {
  id: string;
  name: string;
  symbol?: string;
  icon: string;
  gradient?: string;
}

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
      <DialogContent className="max-w-md gap-0">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
            <Input
              type="text"
              search
              placeholder={searchPlaceholder}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 bg-muted border-0"
            />
          </div>

          {/* Options List */}
          <div className="space-y-1 max-h-[400px] overflow-y-auto">
            {isLoading ? (
              <div className="space-y-1 animate-pulse">
                {[...Array(8)].map((_, i) => (
                  <div
                    key={i}
                    className="w-full flex items-center gap-3 py-3 rounded-lg"
                  >
                    <div className="w-10 h-10 rounded-full bg-muted shrink-0" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 bg-muted rounded w-24" />
                      <div className="h-3 bg-muted rounded w-32" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <>
                {filteredOptions.map((option) => (
                  <Button
                    key={option.id}
                    onClick={() => handleSelect(option)}
                    variant="ghost"
                    className={`w-full flex items-center gap-3 p-3 rounded-lg h-auto justify-start ${selectedId === option.id ? "bg-muted" : ""
                      }`}
                  >
                    {option.icon?.startsWith("http") ||
                      option.icon?.startsWith("data:") ? (
                      <div className="w-10 h-10 rounded-full object-cover">
                        <img src={option.icon} alt={option.symbol || option.name} className="w-full h-full p-2" />
                      </div>
                    ) : (
                      <div
                        className={`w-10 h-10 rounded-full ${option.gradient ||
                          "bg-linear-to-br from-blue-500 to-purple-500"
                          } flex items-center justify-center text-white font-bold`}
                      >
                        <span>{option.icon}</span>
                      </div>
                    )}
                    <div className="flex-1 text-left">
                      <div className="font-semibold">
                        {option.symbol || option.name}
                      </div>
                      {option.symbol && (
                        <div className="text-sm text-muted-foreground">
                          {option.name}
                        </div>
                      )}
                    </div>
                  </Button>
                ))}
                {filteredOptions.length === 0 && !isLoading && (
                  <div className="text-center py-8 text-muted-foreground">
                    No results found
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
