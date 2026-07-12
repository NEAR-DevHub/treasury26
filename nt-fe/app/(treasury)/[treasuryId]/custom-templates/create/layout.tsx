import { CustomTemplatesGuard } from "../guard";

/** Authoring a template needs AddProposal (Requestors + admins, #1046) — gate the create route on
 * top of the subtree guard. */
export default function CreateTemplateLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <CustomTemplatesGuard requireAuthor>{children}</CustomTemplatesGuard>
    );
}
