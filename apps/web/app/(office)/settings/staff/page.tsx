import { listStaff } from '@/lib/queries';
import { requireUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Read-only by design. ADR 0005: accounts are managed from the command
 * line because an admin screen is a login page nobody guards, on the
 * machine that holds every customer's gate code. This page shows the
 * roster and prints the commands — the rule made visible, not violated.
 */
export default async function StaffPage() {
  await requireUser();
  const staff = await listStaff();

  return (
    <>
      <div className="pagehead"><h2>Staff</h2></div>
      <div className="card">
        <table className="roster">
          <thead>
            <tr><th>Name</th><th>Role</th><th>Status</th></tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.display_name}>
                <td>{s.display_name}</td>
                <td><span className="badge">{s.role}</span></td>
                <td>{s.active ? 'active' : <span className="badge bad">deactivated</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3>Managing accounts</h3>
        <p style={{ marginTop: 0 }}>
          There is deliberately no edit form here (ADR 0005). Accounts are
          managed from the repository:
        </p>
        <pre className="cmd">{`npm run db:user -- add --email you@example.com --name "Your Name" --role staff
npm run db:user -- pin --email you@example.com
npm run db:user -- deactivate --email you@example.com`}</pre>
      </div>
    </>
  );
}
