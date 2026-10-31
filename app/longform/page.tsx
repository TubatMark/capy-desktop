import type { Metadata } from "next";
import { LongFormBoard } from "@/components/longform/board";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Long-form · capy" };

export default function LongFormPage() {
  return <LongFormBoard />;
}
