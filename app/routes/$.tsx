import { json } from "@remix-run/node";
import { AppErrorState } from "../components/AppErrorState";

// An explicit route keeps server rendering and lazy client route discovery in
// agreement, including when a merchant opens an unknown link directly.
export const loader = () => json({}, { status: 404 });
export default function MissingPage() {
  return (
    <AppErrorState
      title="Page not found"
      message="This page may have moved. Return to SmartBill to continue."
    />
  );
}
