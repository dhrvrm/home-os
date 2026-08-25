package inventory

import (
	"errors"
	"fmt"
	"time"
)

var (
	ErrNotFound = errors.New("inventory item not found")
	ErrInvalid  = errors.New("invalid inventory input")
)

type ValidationError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

func (e ValidationError) Error() string {
	return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

func (e ValidationError) Unwrap() error { return ErrInvalid }

type TrackingMode string

const (
	TrackingSimple TrackingMode = "simple"
	TrackingExact  TrackingMode = "exact"
)

func (m TrackingMode) Valid() bool { return m == TrackingSimple || m == TrackingExact }

type StockLevel string

const (
	StockFull StockLevel = "full"
	StockOkay StockLevel = "okay"
	StockLow  StockLevel = "low"
	StockOut  StockLevel = "out"
)

func (l StockLevel) Valid() bool {
	return l == StockFull || l == StockOkay || l == StockLow || l == StockOut
}

type EventType string

const (
	EventConsume   EventType = "consume"
	EventRestock   EventType = "restock"
	EventMarkLevel EventType = "mark_level"
)

func (t EventType) Valid() bool {
	return t == EventConsume || t == EventRestock || t == EventMarkLevel
}

type Confidence string

const (
	ConfidenceLow    Confidence = "low"
	ConfidenceMedium Confidence = "medium"
	ConfidenceHigh   Confidence = "high"
)

type Forecast struct {
	DailyUsage    float64    `json:"dailyUsage"`
	DaysRemaining float64    `json:"daysRemaining"`
	Confidence    Confidence `json:"confidence"`
}

type Cadence struct {
	AverageIntervalDays float64    `json:"averageIntervalDays"`
	EventsPerWeek       float64    `json:"eventsPerWeek"`
	LastConsumedAt      time.Time  `json:"lastConsumedAt"`
	Confidence          Confidence `json:"confidence"`
}

type Item struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	Category     string       `json:"category"`
	Location     string       `json:"location"`
	Unit         string       `json:"unit"`
	TrackingMode TrackingMode `json:"trackingMode"`
	Quantity     float64      `json:"quantity"`
	StockLevel   StockLevel   `json:"stockLevel"`
	LevelPercent float64      `json:"levelPercent"`
	MinQuantity  float64      `json:"minQuantity"`
	Forecast     *Forecast    `json:"forecast,omitempty"`
	Cadence      *Cadence     `json:"cadence,omitempty"`
	CreatedAt    time.Time    `json:"createdAt"`
	UpdatedAt    time.Time    `json:"updatedAt"`
}

type StockEvent struct {
	ID           string     `json:"id"`
	ItemID       string     `json:"itemId"`
	Type         EventType  `json:"type"`
	Quantity     float64    `json:"quantity"`
	StockLevel   StockLevel `json:"stockLevel,omitempty"`
	LevelPercent float64    `json:"levelPercent"`
	OccurredAt   time.Time  `json:"occurredAt"`
}

type Filter struct {
	Query      string
	Category   string
	StockLevel StockLevel
}

type CreateItemInput struct {
	Name         string       `json:"name"`
	Category     string       `json:"category"`
	Location     string       `json:"location"`
	Unit         string       `json:"unit"`
	TrackingMode TrackingMode `json:"trackingMode"`
	Quantity     float64      `json:"quantity"`
	StockLevel   StockLevel   `json:"stockLevel"`
	LevelPercent *float64     `json:"levelPercent"`
	MinQuantity  float64      `json:"minQuantity"`
}

type ApplyEventInput struct {
	Type         EventType  `json:"type"`
	Quantity     float64    `json:"quantity"`
	StockLevel   StockLevel `json:"stockLevel"`
	LevelPercent *float64   `json:"levelPercent"`
}
