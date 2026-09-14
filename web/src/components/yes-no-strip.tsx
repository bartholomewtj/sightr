import { Button } from "@/components/ui/button";
export function YesNoStrip({
  onYes,
  onNo,
}: {
  onYes: () => void;
  onNo: () => void;
}) {
  return (
    <div data-yes-no="" className="flex items-center gap-2 px-1 pb-2">
      <Button
        variant="outline"
        size="sm"
        className="h-11 flex-1"
        onClick={onYes}
      >
        Yes
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-11 flex-1"
        onClick={onNo}
      >
        No
      </Button>
    </div>
  );
}
