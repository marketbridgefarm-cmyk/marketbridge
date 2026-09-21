import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
 
import Sidebar from './components/Sidebar.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';

import Home from './pages/Home.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Listings from './pages/Listings.jsx';
import ListingDetail from './pages/ListingDetail.jsx';
import CreateListing from './pages/CreateListing.jsx';
import DigitalMarketplace from './pages/DigitalMarketplace.jsx';

import Dashboard from './pages/Dashboard.jsx';
import InspectorDashboard from './pages/InspectorDashboard.jsx';
import TruckOwnerDashboard from './pages/TruckOwnerDashboard.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';
import AdvertiserDashboard from './pages/AdvertiserDashboard.jsx';

import Services from './pages/Services.jsx';
import ProductMarketplace from './pages/ProductMarketplace.jsx';

import OrderDetail from './pages/OrderDetail.jsx';
import Orders from './pages/Orders.jsx';
import Negotiations from './pages/Negotiations.jsx';

import PaymentReturn from './pages/PaymentReturn.jsx';

import ForgotPassword from './pages/ForgotPassword.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import AccountSecurity from './pages/AccountSecurity.jsx';

export default function App() {
  return (
    <div className="app-shell">
      <Sidebar />

      <div className="app-main">
      <Routes>
        {/* Public pages */}
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

        {/* Protected service hub: buyers and sellers can reach transport and inspection without needing provider roles. */}
        <Route
          path="/services"
          element={
            <ProtectedRoute>
              <Services />
            </ProtectedRoute>
          }
        />

        {/* Protected marketplace pages */}
        <Route
          path="/create-listing"
          element={
            <ProtectedRoute>
              <CreateListing />
            </ProtectedRoute>
          }
        />

        <Route
          path="/orders"
          element={
            <ProtectedRoute>
              <Orders />
            </ProtectedRoute>
          }
        />

        <Route
          path="/negotiations"
          element={
            <ProtectedRoute>
              <Negotiations />
            </ProtectedRoute>
          }
        />

        <Route
          path="/orders/:orderId"
          element={
            <ProtectedRoute>
              <OrderDetail />
            </ProtectedRoute>
          }
        />

        {/* Dashboards */}
        {/* Unified buyer/seller dashboard (PDF recommendation #2) — every
           registered user has both BUYER and SELLER roles by default
           (see backend/src/routes/auth.js DEFAULT_ROLES), so this is a
           single home base rather than two separate pages. The old
           per-role routes below now just redirect here. */}
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />

        <Route path="/dashboard/seller" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard/buyer" element={<Navigate to="/dashboard" replace />} />

        <Route
          path="/dashboard/inspector"
          element={
            <ProtectedRoute role="INSPECTOR">
              <InspectorDashboard />
            </ProtectedRoute>
          }
        />

        <Route
          path="/dashboard/truck-owner"
          element={
            <ProtectedRoute role="TRUCK_OWNER">
              <TruckOwnerDashboard />
            </ProtectedRoute>
          }
        />

        <Route
          path="/dashboard/admin"
          element={
            <ProtectedRoute role="ADMIN">
              <AdminDashboard />
            </ProtectedRoute>
          }
        />

        <Route
          path="/dashboard/advertiser"
          element={
            <ProtectedRoute>
              <AdvertiserDashboard />
            </ProtectedRoute>
          }
        />

        {/* Chapa payment return */}
        <Route
          path="/payments/:paymentId/return"
          element={
            <ProtectedRoute>
              <PaymentReturn />
            </ProtectedRoute>
          }
        />

        {/* Account security (MFA setup/disable) — any logged-in user, but
           required in practice for ADMIN accounts since admin-only backend
           routes now gate on requireMfa(). */}
        <Route
          path="/account/security"
          element={
            <ProtectedRoute>
              <AccountSecurity />
            </ProtectedRoute>
          }
        />

        {/* Fallback */}
        <Route path="*" element={<Home />} />
      </Routes>
      </div>
    </div>
  );
}
