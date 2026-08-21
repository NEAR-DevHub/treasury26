import axios from "axios";
import type {
    AddressBookEntry,
    AddressBookEntryInput,
    CreateAddressBookEntriesInput,
} from "./types";

const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;

export async function getAddressBook(
    daoId: string,
): Promise<AddressBookEntry[]> {
    const response = await axios.get<AddressBookEntry[]>(
        `${BACKEND_API_BASE}/address-book`,
        { params: { daoId }, withCredentials: true },
    );
    return response.data;
}

export async function createAddressBookEntries(
    input: CreateAddressBookEntriesInput,
): Promise<AddressBookEntry[]> {
    const response = await axios.post<AddressBookEntry[]>(
        `${BACKEND_API_BASE}/address-book`,
        input,
        { withCredentials: true },
    );
    return response.data;
}

/** Convenience wrapper for creating a single entry. Null when the entry already exists. */
export async function createAddressBookEntry(
    daoId: string,
    entry: AddressBookEntryInput,
): Promise<AddressBookEntry | null> {
    const created = await createAddressBookEntries({
        daoId,
        entries: [entry],
    });
    return created[0] ?? null;
}

export async function deleteAddressBookEntries(ids: string[]): Promise<void> {
    await axios.delete(`${BACKEND_API_BASE}/address-book`, {
        data: { ids },
        withCredentials: true,
    });
}

export async function exportAddressBook(
    daoId: string,
    ids?: string[],
): Promise<void> {
    const params: Record<string, string> = { daoId };
    if (ids && ids.length > 0) {
        params.ids = ids.join(",");
    }
    const response = await axios.get(
        `${BACKEND_API_BASE}/address-book/export`,
        {
            params,
            withCredentials: true,
            responseType: "blob",
        },
    );
    const url = URL.createObjectURL(response.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = "address-book.csv";
    a.click();
    URL.revokeObjectURL(url);
}
