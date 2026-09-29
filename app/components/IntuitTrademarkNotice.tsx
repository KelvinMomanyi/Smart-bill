import type { ComponentPropsWithoutRef } from "react";

type IntuitTrademarkNoticeProps = Omit<
  ComponentPropsWithoutRef<"p">,
  "children"
>;

export function IntuitTrademarkNotice(props: IntuitTrademarkNoticeProps) {
  return (
    <p {...props}>
      Intuit and QuickBooks are registered trademarks of Intuit Inc. SmartBill
      is an independent application and is not endorsed or sponsored by Intuit
      Inc.
    </p>
  );
}
