import { PageCard } from "@/components/card";
import { InfoDisplay } from "@/components/info-display";
import { User } from "@/components/user";
import { Proposal } from "@/lib/proposals-api";
import { FormattedDate } from "@/components/formatted-date";
import { Policy } from "@/types/policy";

interface TxDetailsProps {
    proposal: Proposal;
    policy: Policy;
}

export function TxDetails({ proposal, policy }: TxDetailsProps) {
    const submissionTimestamp = parseInt(proposal.submission_time) / 1000000;
    const expiresAt = submissionTimestamp + parseInt(policy.proposal_period) / 1000000;

    let creatorInfo: { label: string; value: React.ReactNode }[] = [
        {
            label: "Created By",
            value: <User accountId={proposal.proposer} withName={false} />
        },
        {
            label: "Created Date",
            value: <FormattedDate date={new Date(submissionTimestamp)} />
        },
        {
            label: "Expires At",
            value: <FormattedDate date={new Date(expiresAt)} />
        }
    ];

    return (
        <PageCard className="w-full">
            <InfoDisplay items={creatorInfo} />
        </PageCard>
    );
}
