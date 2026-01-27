import { Button } from "@/components/button";
import { Tooltip } from "@/components/tooltip";
import { ReactNode } from "react";

interface ButtonWithTooltipProps extends React.ComponentProps<typeof Button> {
  /**
   * Message to show in tooltip when button is disabled
   */
  tooltipMessage?: string;
  /**
   * Button content/text
   */
  children: ReactNode;
}

/**
 * A button component with an integrated tooltip that displays messages
 * when the button is disabled (e.g., validation errors, informational messages).
 */
export function ButtonWithTooltip({
  tooltipMessage,
  children,
  ...buttonProps
}: ButtonWithTooltipProps) {
  return (
    <Tooltip
      content={tooltipMessage}
      disabled={!tooltipMessage}
      contentProps={{ className: "max-w-[280px]" }}
    >
      <span className="block w-full">
        <Button {...buttonProps}>{children}</Button>
      </span>
    </Tooltip>
  );
}
