import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/settings/organization/")({
	component: OrganizationSettingsPage,
});

function OrganizationSettingsPage() {
	return <Navigate to="/settings/appearance" replace />;
}
