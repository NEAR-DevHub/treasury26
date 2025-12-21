import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";

interface AddressProps {
    address: string;
    copyable?: boolean;
    prefixLength?: number;
    suffixLength?: number;
}

export function Address({ address, copyable = false, prefixLength = 8, suffixLength = 8 }: AddressProps) {
    const handleCopy = (address: string) => {
        navigator.clipboard.writeText(address);
        toast.success("Address copied to clipboard");
    };

    const prefix = address.slice(0, prefixLength);
    const suffix = address.slice(address.length - suffixLength);
    const displayedAddress = `${prefix}...${suffix}`;
    return <div className="flex items-center gap-2">
        <span>{displayedAddress}</span>
        {copyable && <Button variant="ghost" size="icon-sm" onClick={() => handleCopy(address)}>
            <Copy className="w-4 h-4 shrink-0" />
        </Button>}
    </div>;
}
