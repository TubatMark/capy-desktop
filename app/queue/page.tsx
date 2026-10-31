import { redirect } from "next/navigation";

/** The page was renamed: old links still work. */
export default function QueuePage() {
  redirect("/short-form");
}
