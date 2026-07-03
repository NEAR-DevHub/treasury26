import { CustomTemplatesGuard } from "../guard";

/** Authoring a template requires ChangePolicy — gate the create route on top of the subtree guard. */
export default function CreateTemplateLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <CustomTemplatesGuard requireManage>{children}</CustomTemplatesGuard>
    );
}
