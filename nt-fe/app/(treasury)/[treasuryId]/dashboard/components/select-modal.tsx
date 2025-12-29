import { useState } from "react";
import { X, Search } from "lucide-react";
import { Input } from "@/components/ui/input";

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
}

export function SelectModal({
  isOpen,
  onClose,
  onSelect,
  title,
  options,
  searchPlaceholder = "Search by name",
  isLoading = false,
}: SelectModalProps) {
  const [searchQuery, setSearchQuery] = useState("");

  if (!isOpen) return null;

  const filteredOptions = options.filter((option) => {
    const query = searchQuery.toLowerCase();
    return (
      option.name.toLowerCase().includes(query) ||
      option.symbol?.toLowerCase().includes(query)
    );
  });

  const handleSelect = (option: SelectOption) => {
    onSelect(option);
    onClose();
    setSearchQuery("");
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-60 p-4">
      <div className="bg-card rounded-lg shadow-xl max-w-md w-full">
        {/* Header */}
        <div className="flex items-center justify-between p-6 pb-4 border-b">
          <h2 className="text-xl font-semibold text-center flex-1">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
            <Input
              type="text"
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
                  <div key={i} className="w-full flex items-center gap-3 py-3 rounded-lg">
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
                  <button
                    key={option.id}
                    onClick={() => handleSelect(option)}
                    className="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-muted transition-colors text-left"
                  >
                    {option.icon?.startsWith('http') || option.icon?.startsWith('data:') ? (
                      <img 
                        src={option.icon} 
                        alt={option.symbol || option.name} 
                        className="w-10 h-10 rounded-full object-cover" 
                      />
                    ) : (
                      <div
                        className={`w-10 h-10 rounded-full ${
                          option.gradient || "bg-linear-to-br from-blue-500 to-purple-500"
                        } flex items-center justify-center text-white font-bold`}
                      >
                        <span>{option.icon}</span>
                      </div>
                    )}
                    <div className="flex-1">
                      <div className="font-semibold">{option.symbol || option.name}</div>
                      {option.symbol && (
                        <div className="text-sm text-muted-foreground">{option.name}</div>
                      )}
                    </div>
                  </button>
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
      </div>
    </div>
  );
}

