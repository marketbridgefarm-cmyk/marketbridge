import React, { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

import Sidebar from './components/Sidebar.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';

// Keep the application shell small and load page code only when its route is
// actually opened. This prevents every dashboard/order/service page from
// being downloaded and parsed before the user can see the first screen.
const Home = lazy(() => import('./pages/Home.jsx'));
const Login = lazy(() => import('./pages/Login.jsx'));
const Register = lazy(() => import('./pages/Register.jsx'));
const Listings = lazy(() => import('./pages/Listings.jsx'));
const ListingDetail = lazy(() => import('./pages/ListingDetail.jsx'));
const CreateListing = lazy(() => import('./pages/CreateListing.jsx'));
const DigitalMarketplace = lazy(() => import('./pages/DigitalMarketplace.jsx'));
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const InspectorDashboard = lazy(() => import('./pages/InspectorDashboard.jsx'));
const TruckOwnerDashboard = lazy(() => import('./pages/TruckOwnerDashboard.jsx'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard.jsx'));
const AdvertiserDashboard = lazy(() => import('./pages/AdvertiserDashboard.jsx'));
const Services = lazy(() => import('./pages/Services.jsx'));
const ProductMarketplace = lazy(() => import('./pages/ProductMarketplace.jsx'));
const OrderDetail = lazy(() => import('./pages/OrderDetail.jsx'));
const Orders = lazy(() => import('./pages/Orders.jsx'));
const Negotiations = lazy(() => import('./pages/Negotiations.jsx'));
const PaymentReturn = lazy(() => import('./pages/PaymentReturn.jsx'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword.jsx'));
const ResetPassword = lazy(() => import('./pages/ResetPassword.jsx'));
const AccountSecurity = lazy(() => import('./pages/AccountSecurity.jsx'));

function PageFallback() {
  return (
    <main className="section">
      <div className="container-wide loading" aria-live="polite">Loading page…</div>
    </main>
  );
}

export default function App() {
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />

            <Route path="/listings" element={<Listings />} />
            <Route path="/agricultural" element={<Listings />} />
            <Route path="/listings/:id" element={<ListingDetail />} />
            <Route path="/products" element={<ProductMarketplace />} />
            <Route path="/digital" element={<DigitalMarketplace />} />

            <Route path="/services" element={<ProtectedRoute><Services /></ProtectedRoute>} />
            <Route path="/create-listing" element={<ProtectedRoute><CreateListing /></ProtectedRoute>} />
            <Route path="/orders" element={<ProtectedRoute><Orders /></ProtectedRoute>} />
            <Route path="/negotiations" element={<ProtectedRoute><Negotiations /></ProtectedRoute>} />
            <Route path="/orders/:orderId" element={<ProtectedRoute><OrderDetail /></ProtectedRoute>} />

            <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
            <Route path="/dashboard/seller" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard/buyer" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard/inspector" element={<ProtectedRoute role="INSPECTOR"><InspectorDashboard /></ProtectedRoute>} />
            <Route path="/dashboard/truck-owner" element={<ProtectedRoute role="TRUCK_OWNER"><TruckOwnerDashboard /></ProtectedRoute>} />
            <Route path="/dashboard/admin" element={<ProtectedRoute role="ADMIN"><AdminDashboard /></ProtectedRoute>} />
            <Route path="/dashboard/advertiser" element={<ProtectedRoute><AdvertiserDashboard /></ProtectedRoute>} />

            <Route path="/payments/:paymentId/return" element={<ProtectedRoute><PaymentReturn /></ProtectedRoute>} />
            <Route path="/account/security" element={<ProtectedRoute><AccountSecurity /></ProtectedRoute>} />
            <Route path="*" element={<Home />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}
