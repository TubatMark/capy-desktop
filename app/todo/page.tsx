import type { Metadata } from "next";
import { TodoView } from "@/components/todo-view";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "To do · capy" };

export default function TodoPage() {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <TodoView />
    </div>
  );
}
