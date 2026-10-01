import { Link } from '@tanstack/react-router';
import { Badge } from './ui';

export function ConflictBanner({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div className="banner" role="alert">
      <Badge tone="bad">競合</Badge>
      <span>{count}件</span>
      <Link to="/conflicts">確認する</Link>
    </div>
  );
}
