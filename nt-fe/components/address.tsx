import { CopyButton } from "./copy-button";

interface AddressProps {
    address: string;
    copyable?: boolean;
    prefixLength?: number;
    suffixLength?: number;
}

export function Address({ address, copyable = false, prefixLength = 8, suffixLength = 8 }: AddressProps) {
    const prefix = address.slice(0, prefixLength);
    const suffix = address.slice(address.length - suffixLength);
    const displayedAddress = address.length > prefixLength + suffixLength ? `${prefix}...${suffix}` : address;
    return <div className="flex items-center gap-2">
        <span>{displayedAddress}</span>
        {copyable && <CopyButton
            text={address}
            toastMessage="Address copied to clipboard"
            variant="ghost"
            size="icon-sm"
        />}
    </div>;
}
