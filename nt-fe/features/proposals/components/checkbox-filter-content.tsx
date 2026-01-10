import { Checkbox } from "@/components/ui/checkbox";
import { BaseFilterPopover } from "./base-filter-popover";
import { useFilterState } from "../hooks/use-filter-state";

interface CheckboxFilterOption {
    value: string;
    label: string;
}

interface CheckboxFilterContentProps {
    value: string;
    onUpdate: (value: string) => void;
    setIsOpen: (isOpen: boolean) => void;
    onRemove: () => void;
    filterLabel: string;
    operations: string[];
    options: CheckboxFilterOption[];
    className?: string;
}

interface CheckboxFilterData {
    selected: string[];
}

export function CheckboxFilterContent({
    value,
    onUpdate,
    setIsOpen,
    onRemove,
    filterLabel,
    operations,
    options,
    className,
}: CheckboxFilterContentProps) {
    const { operation, setOperation, data, setData, handleClear } = useFilterState<CheckboxFilterData>({
        value,
        onUpdate,
        parseData: (parsed) => ({
            selected: parsed.selected || []
        }),
        serializeData: (op, d) => ({
            operation: op,
            selected: d.selected
        })
    });

    const handleDelete = () => {
        onRemove();
        setIsOpen(false);
    };

    const handleToggle = (optionValue: string) => {
        const currentSelected = data?.selected || [];
        if (currentSelected.includes(optionValue)) {
            setData({ selected: currentSelected.filter(v => v !== optionValue) });
        } else {
            setData({ selected: [...currentSelected, optionValue] });
        }
    };

    return (
        <BaseFilterPopover
            filterLabel={filterLabel}
            operation={operation}
            operations={operations}
            onOperationChange={setOperation}
            onClear={handleClear}
            onDelete={handleDelete}
            className={className}
        >
            <div className="max-h-60 overflow-y-auto">
                {options.map((option) => (
                    <label
                        key={option.value}
                        className="flex px-2 py-1.5 items-center gap-2 cursor-pointer hover:bg-muted/50 p-2 rounded-md"
                    >
                        <Checkbox
                            checked={data?.selected.includes(option.value) || false}
                            onCheckedChange={() => handleToggle(option.value)}
                        />
                        <span className="text-sm">{option.label}</span>
                    </label>
                ))}
            </div>
        </BaseFilterPopover>
    );
}
