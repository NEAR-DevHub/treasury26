import { CustomTemplatesGuard } from "../../guard";

/** Editing a template requires ChangePolicy — gate the edit route on top of the subtree guard. */
export default function EditTemplateLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <CustomTemplatesGuard requireManage>{children}</CustomTemplatesGuard>
    );
}
