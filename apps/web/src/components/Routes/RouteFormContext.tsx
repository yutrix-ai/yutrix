import { createContext, useContext } from 'react';

export const RouteFormContext = createContext<any>(null);

export const useRouteForm = () => {
  const context = useContext(RouteFormContext);
  if (!context) {
    throw new Error('useRouteForm must be used within RouteFormProvider');
  }
  return context;
};
