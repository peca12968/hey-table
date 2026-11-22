package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

type Report struct {
	PageSize          uint32 `json:"page_size"`
	ValidFrames       int64  `json:"valid_frames"`
	Commits           int64  `json:"commits"`
	LastCommitFrame   int64  `json:"last_commit_frame"`
	LastCommitEnd     int64  `json:"last_commit_end_offset"`
	DatabasePages     uint32 `json:"database_pages_at_last_commit"`
	UncommittedFrames int64  `json:"valid_frames_after_last_commit"`
	Stop              string `json:"stop"`
	StopOffset        int64  `json:"stop_offset"`
}

func checksum(data []byte, order binary.ByteOrder, a, b uint32) (uint32, uint32) {
	for i := 0; i < len(data); i += 8 {
		a += order.Uint32(data[i:]) + b
		b += order.Uint32(data[i+4:]) + a
	}
	return a, b
}

func inspect(input io.Reader) (Report, error) {
	var r Report
	var header [32]byte
	_, err := io.ReadFull(input, header[:])
	if err == io.EOF {
		r.Stop = "empty"
		return r, nil
	}
	if err != nil {
		return r, fmt.Errorf("WAL header: %w", err)
	}
	be := binary.BigEndian.Uint32
	var order binary.ByteOrder
	switch be(header[:]) {
	case 0x377f0682:
		order = binary.LittleEndian
	case 0x377f0683:
		order = binary.BigEndian
	default:
		return r, errors.New("unknown WAL magic")
	}
	if be(header[4:]) != 3007000 {
		return r, errors.New("unsupported WAL version")
	}
	size := be(header[8:])
	if size < 512 || size > 65536 || size&(size-1) != 0 {
		return r, errors.New("invalid page size")
	}
	a, b := checksum(header[:24], order, 0, 0)
	if a != be(header[24:]) || b != be(header[28:]) {
		return r, errors.New("header checksum mismatch")
	}
	r.PageSize, r.StopOffset = size, 32
	frame := make([]byte, 24+size)
	for {
		_, err := io.ReadFull(input, frame)
		if err == io.EOF {
			r.Stop = "end"
			break
		}
		if err == io.ErrUnexpectedEOF {
			r.Stop = "partial_frame"
			break
		}
		if err != nil {
			return r, err
		}
		if binary.BigEndian.Uint64(frame[8:]) != binary.BigEndian.Uint64(header[16:]) {
			r.Stop = "salt_mismatch"
			break
		}
		if be(frame) == 0 {
			r.Stop = "invalid_page"
			break
		}
		a, b = checksum(frame[:8], order, a, b)
		a, b = checksum(frame[24:], order, a, b)
		if a != be(frame[16:]) || b != be(frame[20:]) {
			r.Stop = "checksum_mismatch"
			break
		}
		r.ValidFrames++
		r.StopOffset += int64(len(frame))
		if pages := be(frame[4:]); pages != 0 {
			r.Commits++
			r.LastCommitFrame, r.DatabasePages = r.ValidFrames, pages
			r.LastCommitEnd = r.StopOffset
		}
	}
	r.UncommittedFrames = r.ValidFrames - r.LastCommitFrame
	return r, nil
}

func run() error {
	if len(os.Args) != 2 {
		return errors.New("usage: wal-lantern FILE-wal")
	}
	file, err := os.Open(os.Args[1])
	if err != nil {
		return err
	}
	defer file.Close()
	report, err := inspect(file)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(report)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
}
