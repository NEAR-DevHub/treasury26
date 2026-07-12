import { CustomTemplatesGuard } from "../../guard";

/** Editing a template needs AddProposal (Requestors + admins, #1046) — gate the edit route on top
 * of the subtree guard. */
export default function EditTemplateLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <CustomTemplatesGuard requireAuthor>{children}</CustomTemplatesGuard>
    );
}
