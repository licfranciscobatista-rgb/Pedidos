import { redirect } from "next/navigation";
import { getAppUser } from "./auth";
import Organizador from "./organizador";
export const dynamic = "force-dynamic";
export default async function Page() {
  if (!await getAppUser()) redirect("/login");
  return <Organizador />;
}
