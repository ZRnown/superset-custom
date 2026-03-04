import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-in/")({
	component: SignInPage,
});

function SignInPage() {
	return <Navigate to="/workspace" replace />;
}
