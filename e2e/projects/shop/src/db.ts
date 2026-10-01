export interface User {
  id: string;
  email: string;
  passwordHash: string;
}

export interface Product {
  id: string;
  name: string;
  price: number;
}

const users = new Map<string, User>();
const products = new Map<string, Product>([
  ["p1", { id: "p1", name: "Mug", price: 12 }],
  ["p2", { id: "p2", name: "Shirt", price: 25 }],
]);

export const db = {
  userByEmail: (email: string) => [...users.values()].find((u) => u.email === email),
  addUser: (user: User) => void users.set(user.id, user),
  products: () => [...products.values()],
  product: (id: string) => products.get(id),
};
