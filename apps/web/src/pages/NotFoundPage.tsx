import { ArrowLeft, SearchX } from 'lucide-react';
import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return <div className="not-found"><i><SearchX size={30} /></i><h1>Page not found</h1><p>The workspace route you requested does not exist.</p><Link className="button button-primary" to="/overview"><ArrowLeft size={16} /> Return to overview</Link></div>;
}
