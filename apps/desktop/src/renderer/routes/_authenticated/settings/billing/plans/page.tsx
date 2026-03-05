import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/settings/billing/plans/")({
	component: PlansPage,
});

function PlansPage() {
	return <Navigate to="/settings/appearance" replace />;
}
