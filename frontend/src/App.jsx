import React from 'react';
import { Routes, Route } from 'react-router-dom';

import Navbar from './components/Navbar.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';

import Home from './pages/Home.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Listings from './pages/Listings.jsx';
import ListingDetail from './pages/ListingDetail.jsx';
import CreateListing from './pages/CreateListing.jsx';
import DigitalMarketplace from './pages/DigitalMarketplace.jsx';

import SellerDashboard from './pages/SellerDashboard.jsx';
import BuyerDashboard from './pages/BuyerDashboard.jsx';
import InspectorDashboard from './pages/InspectorDashboard.jsx';
import TruckOwnerDashboard from './pages/TruckOwnerDashboard.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';
import AdvertiserDashboard from './pages/AdvertiserDashboard.jsx';

import ArrangeTransport from './pages/ArrangeTransport.jsx';
import ProductMarketplace from './pages/ProductMarketplace.jsx';

import OrderDetail from './pages/OrderDetail.jsx';
import Orders from './pages/Orders.jsx';

import PaymentReturn from './pages/PaymentReturn.jsx';

export default function App() {
  return (
    <>
      <Navbar />

      <Routes>
        {/* Public pages */}
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />

        <Route path="/listings" element={<Listings />} />
        <Route path="/agricultural" element={<Listings />} />
        <Route path="/listings/:id" element={<ListingDetail />} />

        <Route path="/products" element={<ProductMarketplace />} />
        <Route path="/digital" element={<DigitalMarketplace />} />

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
          path="/orders/:orderId"
          element={
            <ProtectedRoute>
              <OrderDetail />
            </ProtectedRoute>
          }
        />

        <Route
          path="/orders/:orderId/transport"
          element={
            <ProtectedRoute>
              <ArrangeTransport />
            </ProtectedRoute>
          }
        />

        {/* Dashboards */}
        <Route
          path="/dashboard/seller"
          element={
            <ProtectedRoute role="SELLER">
              <SellerDashboard />
            </ProtectedRoute>
          }
        />

        <Route
          path="/dashboard/buyer"
          element={
            <ProtectedRoute role="BUYER">
              <BuyerDashboard />
            </ProtectedRoute>
          }
        />

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

        {/* Fallback */}
        <Route path="*" element={<Home />} />
      </Routes>
    </>
  );
}
