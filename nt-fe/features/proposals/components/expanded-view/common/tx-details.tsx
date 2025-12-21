import { PageCard } from "@/components/card";
import { InfoDisplay } from "@/components/info-display";
import { User } from "@/components/user";
import { Proposal } from "@/lib/proposals-api";
import { formatDate } from "@/lib/utils";
import { Policy } from "@/types/policy";

interface TxDetailsProps {
    proposal: Proposal;
    policy: Policy;
}

export function TxDetails({ proposal, policy }: TxDetailsProps) {
    const submissionTimestamp = parseInt(proposal.submission_time) / 1000000;

    let creatorInfo: { label: string; value: React.ReactNode }[] = [
        {
            label: "Created By",
            value: <User accountId={proposal.proposer} withName={false} />
        },
        {
            label: "Created Date",
            value: formatDate(new Date(submissionTimestamp))
        },
        {
            label: "Expires At",
            value: formatDate(new Date(submissionTimestamp + parseInt(policy.proposal_period) / 1000000))
        }
    ];

    return (
        <PageCard className="w-full">
            <InfoDisplay items={creatorInfo} />
        </PageCard>
    );
}
