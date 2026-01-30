// Jest setup file
import 'reflect-metadata';

// Mock console methods to reduce noise in __tests__
global.console = {
  ...console,
  // Uncomment to suppress console output during __tests__
  // log: jest.fn(),
  // debug: jest.fn(),
  // info: jest.fn(),
  // warn: jest.fn(),
  // error: jest.fn(),
};
