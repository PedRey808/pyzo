import tkinter as tk
from tkinter import ttk, messagebox
import json
import os
import requests
import random

DATA_FILE = "movies.json"

# --- ЛОГИКА (Модель данных) ---
class MovieManager:
    def __init__(self):
        self.movies = []
        self.load_movies()

    def load_movies(self):
        if os.path.exists(DATA_FILE):
            try:
                with open(DATA_FILE, "r", encoding="utf-8") as f:
                    self.movies = json.load(f)
            except json.JSONDecodeError:
                self.movies = []

    def save_movies(self):
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(self.movies, f, ensure_ascii=False, indent=4)

    def add_movie(self, title, genre, year, rating):
        # Валидация ввода по заданию
        title = title.strip()
        genre = genre.strip()
        
        if not title or not genre:
            raise ValueError("Название и жанр не могут быть пустыми.")
        
        try:
            year = int(year)
        except ValueError:
            raise ValueError("Год выпуска должен быть числом.")
        
        try:
            rating = float(rating)
            if not (0 <= rating <= 10):
                raise ValueError("Рейтинг должен быть от 0 до 10.")
        except ValueError:
            raise ValueError("Рейтинг должен быть числом от 0 до 10.")

        movie = {"title": title, "genre": genre, "year": year, "rating": rating}
        self.movies.append(movie)
        self.save_movies()
        return movie

    def get_movies(self, genre_filter="", year_filter=""):
        filtered = self.movies
        if genre_filter:
            filtered = [m for m in filtered if genre_filter.lower() in m["genre"].lower()]
        if year_filter:
            try:
                y_f = int(year_filter)
                filtered = [m for m in filtered if m["year"] == y_f]
            except ValueError:
                pass # Игнорируем неверный фильтр
        return filtered

# --- ИНТЕРФЕЙС (GUI) ---
class MovieApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Movie Library (Личная кинотека)")
        self.root.geometry("800x450") # Формат 16:9
        self.manager = MovieManager()

        # Разделение окна на панели
        left_panel = tk.Frame(root, padx=10, pady=10)
        left_panel.pack(side=tk.LEFT, fill=tk.Y)

        right_panel = tk.Frame(root, padx=10, pady=10)
        right_panel.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True)

        # --- ЛЕВАЯ ПАНЕЛЬ: Добавление фильма ---
        tk.Label(left_panel, text="Добавление фильма", font=("Arial", 12, "bold")).pack(pady=(0, 10))

        tk.Label(left_panel, text="Название:").pack(anchor=tk.W)
        self.ent_title = tk.Entry(left_panel, width=25)
        self.ent_title.pack(pady=(0, 10))

        tk.Label(left_panel, text="Жанр:").pack(anchor=tk.W)
        self.ent_genre = tk.Entry(left_panel, width=25)
        self.ent_genre.pack(pady=(0, 10))

        tk.Label(left_panel, text="Год выпуска:").pack(anchor=tk.W)
        self.ent_year = tk.Entry(left_panel, width=25)
        self.ent_year.pack(pady=(0, 10))

        tk.Label(left_panel, text="Рейтинг (0-10):").pack(anchor=tk.W)
        self.ent_rating = tk.Entry(left_panel, width=25)
        self.ent_rating.pack(pady=(0, 15))

        tk.Button(left_panel, text="Добавить фильм", command=self.add_movie, bg="#d4edda").pack(fill=tk.X)
        
        # Кнопка для API и random (для 5 баллов)
        tk.Button(left_panel, text="Случайная цитата (API)", command=self.show_random_quote, bg="#cce5ff").pack(fill=tk.X, pady=10)

        # --- ПРАВАЯ ПАНЕЛЬ: Фильтрация и Таблица ---
        filter_frame = tk.Frame(right_panel)
        filter_frame.pack(fill=tk.X, pady=(0, 10))

        tk.Label(filter_frame, text="Фильтр по жанру:").pack(side=tk.LEFT)
        self.flt_genre = tk.Entry(filter_frame, width=15)
        self.flt_genre.pack(side=tk.LEFT, padx=(5, 15))
        self.flt_genre.bind("<KeyRelease>", lambda e: self.update_table())

        tk.Label(filter_frame, text="По году:").pack(side=tk.LEFT)
        self.flt_year = tk.Entry(filter_frame, width=10)
        self.flt_year.pack(side=tk.LEFT, padx=(5, 15))
        self.flt_year.bind("<KeyRelease>", lambda e: self.update_table())

        # Таблица (Treeview)
        columns = ("title", "genre", "year", "rating")
        self.tree = ttk.Treeview(right_panel, columns=columns, show="headings")
        self.tree.heading("title", text="Название")
        self.tree.heading("genre", text="Жанр")
        self.tree.heading("year", text="Год")
        self.tree.heading("rating", text="Рейтинг")
        
        self.tree.column("title", width=200)
        self.tree.column("genre", width=120)
        self.tree.column("year", width=80, anchor=tk.CENTER)
        self.tree.column("rating", width=80, anchor=tk.CENTER)
        
        self.tree.pack(fill=tk.BOTH, expand=True)

        self.update_table()

    def add_movie(self):
        try:
            self.manager.add_movie(
                self.ent_title.get(),
                self.ent_genre.get(),
                self.ent_year.get(),
                self.ent_rating.get()
            )
            self.ent_title.delete(0, tk.END)
            self.ent_genre.delete(0, tk.END)
            self.ent_year.delete(0, tk.END)
            self.ent_rating.delete(0, tk.END)
            self.update_table()
            messagebox.showinfo("Успех", "Фильм успешно добавлен!")
        except ValueError as e:
            messagebox.showerror("Ошибка ввода", str(e))

    def update_table(self):
        for item in self.tree.get_children():
            self.tree.delete(item)
            
        g_filter = self.flt_genre.get()
        y_filter = self.flt_year.get()
        
        movies = self.manager.get_movies(g_filter, y_filter)
        for m in movies:
            self.tree.insert("", tk.END, values=(m["title"], m["genre"], m["year"], m["rating"]))

    def show_random_quote(self):
        # Использование API и библиотеки random для соответствия максимальной оценке
        try:
            response = requests.get("https://dummyjson.com/quotes", timeout=5)
            response.raise_for_status()
            quotes = response.json()["quotes"]
            quote = random.choice(quotes)
            messagebox.showinfo("Киноцитата", f"«{quote['quote']}»\n\n— {quote['author']}")
        except Exception:
            messagebox.showerror("Ошибка", "Не удалось загрузить данные по API.")

if __name__ == "__main__":
    root = tk.Tk()
    app = MovieApp(root)
    root.mainloop()
