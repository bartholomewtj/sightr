// "New project…" (T14): a name and a folder path on the host. It posts `project.create` (T07), which
// makes a herdr workspace there; the bridge checks the folder and refuses a missing one with the reason.
// The new project is selected when its `project.upserted` event (same commandId) arrives.
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { closeNewProjectForm, createDraftProject, setNewProjectField, useDraftThread } from "@/state/draft-thread";

export function NewProjectForm({ canCancel }: { canCancel: boolean }) {
  const form = useDraftThread((s) => s.form);
  const creating = form.commandId !== null;
  return (
    <form
      aria-label="New project"
      className="flex w-full max-w-md flex-col gap-2 rounded-lg border bg-card p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void createDraftProject();
      }}
    >
      <p className="text-sm font-medium">New project</p>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Name
        <Input value={form.label} disabled={creating} onChange={(e) => setNewProjectField("label", e.target.value)} placeholder="Optional" />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Folder on the host
        <Input
          value={form.cwd}
          disabled={creating}
          font="mono"
          onChange={(e) => setNewProjectField("cwd", e.target.value)}
          placeholder="C:\\path\\to\\folder"
          spellCheck={false}
          autoCapitalize="off"
        />
      </label>
      {form.error ? (
        <p role="alert" className="text-sm text-warn">
          {form.error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        {canCancel ? (
          <Button type="button" size="sm" variant="ghost" disabled={creating} onClick={closeNewProjectForm}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={creating}>
          {creating ? "Creating…" : "Create project"}
        </Button>
      </div>
    </form>
  );
}
