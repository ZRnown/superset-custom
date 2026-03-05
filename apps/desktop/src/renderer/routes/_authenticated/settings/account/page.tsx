import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/settings/account/")({
	component: AccountSettingsPage,
});

function AccountSettingsPage() {
	return <Navigate to="/settings/appearance" replace />;
}
