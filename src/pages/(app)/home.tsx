import { Navigate } from 'react-router-dom'

/** The board is the app. Keep /home working for old links and the nav shell test. */
export default function HomePage() {
  return <Navigate to="/board" replace />
}
