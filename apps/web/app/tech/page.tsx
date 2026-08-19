import TechApp from './TechApp';
import RegisterSW from './RegisterSW';

export const dynamic = 'force-dynamic';

export default function TechPage() {
  return (
    <>
      <RegisterSW />
      <TechApp />
    </>
  );
}
