import { ProjectList } from "@/components/studio/project-list";
export const dynamic = "force-dynamic";
export const metadata = { title: "Studio · capy" };
export default function StudioPage() {
  return (
    <div className="mx-auto max-w-6xl">
      <ProjectList />
    </div>
  );
}
