import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/settings/billing/")({
	component: BillingPage,
});

function BillingPage() {
	return <Navigate to="/settings/appearance" replace />;
}
