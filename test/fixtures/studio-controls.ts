import { expect, type APIRequestContext } from "@playwright/test";

/** Local import/export needs the real worker, without monitoring or posting. */
export async function allowLocalStudioWork(request: APIRequestContext) {
  const controls = {
    globalStop: false,
    renderPaused: false,
    monitorPaused: true,
    postPaused: true,
  };
  const response = await request.put("/api/automation/health", {
    data: { controls },
  });
  expect(response.ok(), await response.text()).toBe(true);
  expect((await response.json()).controls).toEqual(controls);
}
