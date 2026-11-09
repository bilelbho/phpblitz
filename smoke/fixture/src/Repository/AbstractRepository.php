<?php

declare(strict_types=1);

namespace App\Repository;

/**
 * @template T of object
 */
abstract class AbstractRepository
{
    /** @var list<T> */
    protected array $items = [];

    /**
     * @return list<T>
     */
    public function findAll(): array
    {
        return $this->items;
    }
}
