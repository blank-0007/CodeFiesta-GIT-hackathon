import { Link } from "react-router-dom";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";

export function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-24 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-muted-foreground">
        <Compass className="h-6 w-6" aria-hidden />
      </div>
      <p className="num text-sm text-muted-foreground">404</p>
      <h1 className="mt-1 text-xl font-semibold">This page doesn't exist</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The link may be out of date, or the run or finding may have been archived.
      </p>
      <div className="mt-6 flex gap-2">
        <Button asChild>
          <Link to="/">Go to dashboard</Link>
        </Button>
        <Button asChild variant="secondary">
          <Link to="/runs">View runs</Link>
        </Button>
      </div>
    </div>
  );
}
