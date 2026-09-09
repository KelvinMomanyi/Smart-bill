import { processNextInvoiceJob } from "../app/services/invoiceJobs.server";
import prisma from "../app/db.server";
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
while (!stopping) {
  try {
    if (!(await processNextInvoiceJob()))
      await new Promise((resolve) => setTimeout(resolve, 3000));
  } catch (error) {
    console.error(
      "Invoice worker error:",
      error instanceof Error ? error.message : "Unknown failure",
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
await prisma.$disconnect();
